from setuptools import setup, find_packages

setup(
    name='cloud-publish',
    version='0.1.0',
    description='Publish files to laifu cloud drive (Hermes skill)',
    packages=find_packages(exclude=['tests']),
    python_requires='>=3.10',
    install_requires=[
        'azure-storage-blob>=12.20.0',
    ],
    entry_points={
        'console_scripts': [
            'cloud-publish=cloud_publish.__main__:main',
            'cloud-download=cloud_publish.download_cli:main',
        ],
    },
)
