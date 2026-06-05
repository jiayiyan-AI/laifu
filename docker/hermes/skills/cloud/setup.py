from setuptools import setup, find_packages

setup(
    name='cloud-file',
    version='0.1.0',
    description='Manage files on the laifu cloud drive (Hermes skill: ls/get/put)',
    packages=find_packages(exclude=['tests']),
    python_requires='>=3.10',
    install_requires=[
        'azure-storage-blob>=12.20.0',
    ],
    entry_points={
        'console_scripts': [
            'cloud-file=cloud_file.cli:main',
        ],
    },
)
